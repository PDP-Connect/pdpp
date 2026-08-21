// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface Manifest {
  capabilities: {
    public_listing: { tier: string };
    refresh_policy: { background_safe: boolean; recommended_mode: string; rationale: string };
  };
}

const manifest = JSON.parse(
  readFileSync(new URL("../../manifests/jellyfin.json", import.meta.url), "utf8")
) as Manifest;

test("Jellyfin remains Preview until live version capability is proven", () => {
  // `public_listing.tier` is what actually withholds Jellyfin from
  // auto-enrollment and from the dashboard catalog, so it is the assertion
  // that carries this test's intent.
  //
  // This test used to ALSO pin `recommended_mode: "manual"` and
  // `background_safe: false`. Those encoded "not proven yet" as a claim
  // about background SAFETY, which is a different fact: Jellyfin is a
  // self-hosted API-key connector with no interactive login, so there is
  // nothing about it that makes unattended refresh unsafe. Maturity belongs
  // to the tier; capability belongs to the refresh policy. Mode is now
  // derived from capability (reference-implementation/runtime/
  // refresh-mode-derivation.ts), so pinning it here would re-introduce the
  // contradiction the derivation exists to prevent.
  assert.equal(manifest.capabilities.public_listing.tier, "preview");
  assert.match(manifest.capabilities.refresh_policy.rationale, /unproven/i);
  // The unproven-ness must still be stated in owner-readable terms.
  assert.match(manifest.capabilities.refresh_policy.rationale, /version and credentialed-deployment/i);
});
