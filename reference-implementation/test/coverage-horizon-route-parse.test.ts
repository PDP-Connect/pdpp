// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Evidence-integrity controls on the coverage-horizon write path.
 *
 * A coverage horizon narrows the current servable denominator: it is the one
 * owner-supplied fact that can make a source stop reporting a gap. That makes
 * its provenance load-bearing, not decorative — if "who confirmed this, when,
 * and on what basis" can be forged or post-dated, the record is theatre.
 *
 * These pin the two controls that are NOT ordinary validation hygiene:
 * the actor comes from the authenticated session and cannot be supplied, and
 * a confirmation cannot be stamped in the future.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseCoverageHorizonBody } from "../server/routes/ref-connection-confirm-coverage-horizon.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const OWNER = "owner_subject_abc";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    basis: "provider_confirmed",
    earliest_available: "2013-01-01T00:00:00.000Z",
    reason: "provider_retention_policy",
    stream: "group_messages",
    ...overrides,
  };
}

test("the actor is the authenticated owner, never the request body", () => {
  const parsed = parseCoverageHorizonBody(body(), NOW, OWNER);
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.ok && parsed.record.confirmedBy,
    OWNER,
    "confirmedBy must be the session subject; a body-supplied actor would make attribution forgeable"
  );
});

test("a body that tries to set confirmed_by is REFUSED, not silently ignored", () => {
  // Ignoring it would leave the caller believing an attribution the system did
  // not honour — worse than refusing, because it is invisible.
  const parsed = parseCoverageHorizonBody(body({ confirmed_by: "someone_else" }), NOW, OWNER);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /confirmed_by is not accepted/);
});

test("no authenticated owner subject means no horizon", () => {
  const parsed = parseCoverageHorizonBody(body(), NOW, "");
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /authenticated owner subject is required/);
});

test("a future confirmed_at is refused", () => {
  // Every read treats a current horizon as live disclosure, so a future stamp
  // would present as live immediately while reading as not-yet-valid.
  const parsed = parseCoverageHorizonBody(body({ confirmed_at: "2027-01-01T00:00:00.000Z" }), NOW, OWNER);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /confirmed_at must not be in the future/);
});

test("an earliest_available later than confirmed_at is refused", () => {
  // A boundary stamped in the future describes a nonsensical interval — it
  // would disclose that NO history is available. Refused at the route so the
  // record stays coherent for the owner reading it.
  const parsed = parseCoverageHorizonBody(body({ earliest_available: "2026-12-31T00:00:00.000Z" }), NOW, OWNER);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /must not be later than confirmed_at/);
});

test("basis and reason are closed vocabularies, refused when unrecognized", () => {
  const badBasis = parseCoverageHorizonBody(body({ basis: "i_reckon" }), NOW, OWNER);
  assert.equal(badBasis.ok, false);
  assert.match(badBasis.ok ? "" : badBasis.error, /basis must be one of/);

  const badReason = parseCoverageHorizonBody(body({ reason: "provider_was_unhelpful" }), NOW, OWNER);
  assert.equal(badReason.ok, false);
  assert.match(badReason.ok ? "" : badReason.error, /reason must be one of/);
});

test("a weak basis is accepted but recorded AS weak, never upgraded", () => {
  // The research treats `inferred_from_stable_boundary` as provisional. The
  // route's job is to record it faithfully, not to refuse it or launder it
  // into a settled one. No basis narrows the coverage denominator any more —
  // the basis is provenance an owner reads; see
  // coverage-horizon-weak-basis.test.ts for that proven through the real
  // projection.
  const parsed = parseCoverageHorizonBody(body({ basis: "inferred_from_stable_boundary" }), NOW, OWNER);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.record.basis, "inferred_from_stable_boundary");
});

test("earliest_available may be null — the provider never had the data at all", () => {
  const parsed = parseCoverageHorizonBody(
    body({ earliest_available: null, reason: "provider_never_had_data" }),
    NOW,
    OWNER
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.record.earliestAvailable, null);
});

test("even if the refusal were removed, a body actor must never reach the record", () => {
  // Defence in depth, pinned. The refusal above rejects `confirmed_by`
  // outright, which makes the assignment below unreachable — and an
  // unreachable guard is invisible to mutation testing until something
  // removes the guard in front of it. This asserts the SECOND line of
  // defence directly: whatever the body says, the recorded actor is the
  // session subject.
  const parsed = parseCoverageHorizonBody(body({ note: "confirmed from the provider's help page" }), NOW, OWNER);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.record.confirmedBy, OWNER);
  assert.equal(
    parsed.ok && (parsed.record as unknown as Record<string, unknown>).confirmed_by,
    undefined,
    "no body-shaped actor field survives into the store input"
  );
});
