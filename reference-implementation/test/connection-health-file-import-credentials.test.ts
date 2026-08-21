// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A file-import connector authenticates to nobody.
//
// Google Maps Timeline Import (299,248 records) and WhatsApp (120,042) both
// declare `setup.modality = "manual_or_upload"` with no
// `setup.credential_capture`: the owner exports the artifact from the provider
// themselves and uploads it. PDPP parses a local file and never contacts the
// provider, so it stores no credential and opens no session.
//
// Under the shipped model both render `CredentialsValid: unknown` with reason
// `credentials_not_probed` — "Credential validity has not been proven by
// current evidence" — forever. No owner action and no future run can ever close
// that, because there is no credential to probe. It is an unanswerable question
// presented as an outstanding one.
//
// The rule under test: for a connection that authenticates to no provider,
// `CredentialsValid` is `not_applicable` — a settled answer — not `unknown`.
// The safety property, which the last three tests pin: inapplicability may only
// come from the durable manifest declaration, and contradicting evidence (a
// stored credential, or a credential-shaped run reason) always wins, because
// "this connector has no credentials" must never silence a real credential
// failure.

import assert from "node:assert/strict";
import test from "node:test";

import type { ComputeConnectionHealthInput } from "../runtime/connection-health.ts";
import { computeConnectionHealth } from "../runtime/connection-health.ts";

const NOW = "2026-08-20T12:00:00.000Z";

/** A finished file import: no credential, no session, no run history. */
function fileImport(overrides: Partial<ComputeConnectionHealthInput> = {}): ComputeConnectionHealthInput {
  return {
    acquisition: { complete: true },
    activity: null,
    attention: null,
    authentication: { authenticates: false },
    backoff: null,
    coverage: { axis: "complete" },
    freshness: null,
    observedAt: NOW,
    outbox: null,
    projection: null,
    run: null,
    schedule: null,
    ...overrides,
  };
}

function credentialsCondition(input: ComputeConnectionHealthInput) {
  return computeConnectionHealth(input).conditions.find((item) => item.type === "CredentialsValid");
}

test("a file import reports CredentialsValid as not_applicable, not unknown", () => {
  const credentials = credentialsCondition(fileImport());
  assert.equal(credentials?.status, "not_applicable");
  assert.equal(credentials?.reason, "credentials_not_applicable_file_import");
  assert.equal(credentials?.severity, "info");
});

test("the not-applicable credential verdict offers the owner no repair action", () => {
  // `not_applicable` is a settled answer, so there is nothing to fix. Attaching
  // a "Reconnect this account" CTA to a source with no account would be the
  // same false prompt in a new place.
  const credentials = credentialsCondition(fileImport());
  assert.equal(credentials?.remediation, null);
});

test("an authenticating connector is unaffected and keeps its honest unknown", () => {
  // The identical shape WITHOUT the declaration must preserve shipped behavior
  // exactly: credentials stay `unknown` until something proves them.
  const credentials = credentialsCondition(fileImport({ authentication: null }));
  assert.equal(credentials?.status, "unknown");
  assert.equal(credentials?.reason, "credentials_not_probed");
});

test("a stored credential overrides the declaration rather than being silenced", () => {
  // Durable evidence that a credential EXISTS contradicts "authenticates to
  // nothing". The declaration is then wrong or stale, and the credential's own
  // state must be projected. A rejected credential is an owner-actionable
  // failure; `not_applicable` here would hide it.
  const credentials = credentialsCondition(
    fileImport({ credential: { capable: true, present: true, rejected: true } })
  );
  assert.equal(credentials?.status, "false");
  assert.notEqual(credentials?.reason, "credentials_not_applicable_file_import");
});

test("a missing-credential state is projected, not waved through as inapplicable", () => {
  const credentials = credentialsCondition(fileImport({ credential: { capable: true, present: false } }));
  assert.equal(credentials?.status, "false");
  assert.equal(credentials?.reason, "credential_required");
});

test("a credential-shaped run reason is never masked by the declaration", () => {
  // Something authenticated and was refused. Whatever the manifest declares,
  // that is a real failure the owner must see.
  const credentials = credentialsCondition(
    fileImport({
      run: {
        hasDegradingGaps: false,
        lastSuccessAt: null,
        latestStatus: "failed",
        reasonCode: "credential_rejected",
      },
    })
  );
  assert.notEqual(credentials?.status, "not_applicable");
  assert.notEqual(credentials?.reason, "credentials_not_applicable_file_import");
});
