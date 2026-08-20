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
 * event. This suite proves that gap is closed.
 *
 * WHAT THIS FILE TESTS, AND WHAT IT DOES NOT
 * ------------------------------------------
 * These are RI-side tests, so they exercise the RI's side of the contract:
 * given a manifest that declares tokens, does redaction honor them, and does
 * a manifest that declares none stay byte-identical to prior behavior. The
 * manifests below are SYNTHETIC — the RI must work for any connector, so
 * pinning these tests to a real connector's file would re-import exactly the
 * connector knowledge this seam exists to remove.
 *
 * The DRIFT check — that Venmo's real manifest array still equals the
 * `VENMO_DECLARED_REASON_TOKENS` constant its throw sites actually use —
 * lives connector-side, next to the source of truth, in
 * `packages/polyfill-connectors/src/auto-login/venmo-declared-reason-tokens-manifest.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { boundConnectorErrorMessage } from "../runtime/connector-gap-bounding.ts";
import { declaredReasonTokensFor } from "../runtime/declared-reason-tokens.ts";

/**
 * A synthetic token of the same length class as the real production one (31
 * chars vs `venmo_probe_transport_error`'s 27) — both well over the 24-char
 * threshold where `LONG_OPAQUE_RE` starts eating.
 *
 * The `fake_session_failed:` prefix in the fixtures below is deliberately 19
 * chars, mirroring the real `venmo_session_failed:`. It has to stay under 24
 * or LONG_OPAQUE_RE redacts the PREFIX too, and these assertions would then
 * be pinning two redactions while claiming to pin one.
 */
const DECLARED_TOKEN = "synthetic_probe_transport_error";
const manifestDeclaring = (tokens: readonly string[]) => ({
  capabilities: { declared_reason_tokens: tokens },
});

test("regression: the production defect reproduced — without declared tokens, a >=24-char reason code is eaten", () => {
  const raw = `fake_session_failed: ${DECLARED_TOKEN}: Failed to fetch`;
  assert.equal(boundConnectorErrorMessage(raw), "fake_session_failed: [REDACTED]: Failed to fetch");
});

test("fix: boundConnectorErrorMessage with manifest-declared tokens preserves the real cause", () => {
  const raw = `fake_session_failed: ${DECLARED_TOKEN}: Failed to fetch`;
  const declared = declaredReasonTokensFor(manifestDeclaring([DECLARED_TOKEN]));
  assert.ok(declared, "a manifest declaring tokens must resolve a non-empty set");
  assert.equal(boundConnectorErrorMessage(raw, declared), raw, "the declared token must survive verbatim");
});

test("declaredReasonTokensFor reads the manifest generically, with no connector id anywhere", () => {
  const declared = declaredReasonTokensFor(manifestDeclaring([DECLARED_TOKEN, "another_declared_reason_token_x"]));
  assert.deepEqual(declared, new Set([DECLARED_TOKEN, "another_declared_reason_token_x"]));
});

test("declaredReasonTokensFor returns undefined when nothing is declared — byte-identical prior behavior", () => {
  assert.equal(declaredReasonTokensFor(undefined), undefined);
  assert.equal(declaredReasonTokensFor(null), undefined);
  assert.equal(declaredReasonTokensFor({}), undefined);
  assert.equal(declaredReasonTokensFor({ capabilities: {} }), undefined);
  assert.equal(declaredReasonTokensFor(manifestDeclaring([])), undefined);
  // And boundConnectorErrorMessage with no declared set still redacts exactly
  // as before for a connector that declares nothing.
  const raw = "fake_session_failed: some_twenty_four_plus_char_token";
  assert.equal(boundConnectorErrorMessage(raw, declaredReasonTokensFor({})), boundConnectorErrorMessage(raw));
});

test("declaredReasonTokensFor skips non-string and empty entries rather than throwing on the terminal path", () => {
  const declared = declaredReasonTokensFor({
    capabilities: { declared_reason_tokens: [DECLARED_TOKEN, "", 42, null, { nested: true }] },
  });
  assert.deepEqual(declared, new Set([DECLARED_TOKEN]));
  assert.equal(declaredReasonTokensFor({ capabilities: { declared_reason_tokens: "not_an_array" } }), undefined);
});

const SECRET_MUST_NOT_SURVIVE_RE = /SECRETVALUEXXXXXXXXXXXXX/;

test("secrets embedded alongside a declared token are still redacted — the allowlist cannot become a hole", () => {
  const declared = declaredReasonTokensFor(manifestDeclaring([DECLARED_TOKEN]));
  const hostile = `fake_session_failed: ${DECLARED_TOKEN}: token=SECRETVALUEXXXXXXXXXXXXX`;
  const result = boundConnectorErrorMessage(hostile, declared);
  assert.ok(result);
  assert.doesNotMatch(
    result,
    SECRET_MUST_NOT_SURVIVE_RE,
    "a real secret must not survive just because a declared token is nearby"
  );
  assert.ok(result.includes(DECLARED_TOKEN), "the declared token itself still survives");
});
