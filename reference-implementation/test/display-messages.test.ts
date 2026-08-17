// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for RI's own generic-only reason-display contract
 * (`runtime/display-messages.ts`). Scoped to RI's slice ONLY — this file
 * must never import `@pdpp/polyfill-connectors` or assert anything about
 * connector-emitted reason codes; that completeness authority lives in
 * `packages/polyfill-connectors/src/reason-display-messages.test.ts`, which
 * imports `RUNTIME_GENERIC_REASON_CODES` from here (by relative path) to
 * check the boundary from the other side.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DISPLAY_MESSAGES, displayMessageFor } from "../runtime/display-messages.ts";
import { RUNTIME_GENERIC_REASON_CODES } from "../runtime/recovery-reason-codes.ts";

// ─── Module-shape sanity ───────────────────────────────────────────────────

test("displayMessageFor returns null for null/empty input", () => {
  assert.equal(displayMessageFor(null), null);
  assert.equal(displayMessageFor(""), null);
});

test("displayMessageFor returns the registry entry for a known RI-generic code", () => {
  assert.equal(displayMessageFor("temporary_unavailable"), DISPLAY_MESSAGES.temporary_unavailable);
});

test("displayMessageFor returns null for an unregistered code (caller handles fallback)", () => {
  assert.equal(displayMessageFor("definitely_not_a_real_reason_code"), null);
});

test("displayMessageFor returns null for a connector-specific code (out of this file's scope)", () => {
  // cloudflare_challenge is a real chase-emitted reason code, but RI's
  // generic-only registry must not know that — it isn't in
  // RUNTIME_GENERIC_REASON_CODES, so this must resolve null here even
  // though the connector package's merged map does cover it.
  assert.equal(displayMessageFor("cloudflare_challenge"), null);
});

// ─── Registry-quality invariants ───────────────────────────────────────────

test("no registry value is an empty string", () => {
  for (const [key, value] of Object.entries(DISPLAY_MESSAGES)) {
    assert.notEqual(value, "", `DISPLAY_MESSAGES[${key}] is empty`);
    assert.equal(typeof value, "string", `DISPLAY_MESSAGES[${key}] must be a string`);
  }
});

test("no bare reason-code-as-value entries (registry must translate, not parrot)", () => {
  for (const [key, value] of Object.entries(DISPLAY_MESSAGES)) {
    assert.notEqual(
      value,
      key,
      `DISPLAY_MESSAGES[${key}] is the same as its key — that just relocates the confusion. Write an end-user-vetted message.`
    );
  }
});

test("every RUNTIME_GENERIC_REASON_CODES member has a registered display message", () => {
  const missing = [...RUNTIME_GENERIC_REASON_CODES].filter((code) => !(code in DISPLAY_MESSAGES));
  assert.deepEqual(missing, [], `RUNTIME_GENERIC_REASON_CODES entries missing display copy: ${missing.join(", ")}`);
});

test("DISPLAY_MESSAGES contains exactly RUNTIME_GENERIC_REASON_CODES, nothing else (falsifiability: this file cannot silently accrue connector-specific entries)", () => {
  const registryKeys = new Set(Object.keys(DISPLAY_MESSAGES));
  const genericKeys = new Set(RUNTIME_GENERIC_REASON_CODES);
  assert.deepEqual(
    [...registryKeys].sort(),
    [...genericKeys].sort(),
    "DISPLAY_MESSAGES must contain exactly the RI-owned generic recovery vocabulary — " +
      "a connector-specific reason code appearing here would be a regression back into hardcoded connector knowledge."
  );
});
