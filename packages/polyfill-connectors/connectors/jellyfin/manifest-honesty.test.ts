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
  assert.equal(manifest.capabilities.public_listing.tier, "preview");
  assert.equal(manifest.capabilities.refresh_policy.recommended_mode, "manual");
  assert.equal(manifest.capabilities.refresh_policy.background_safe, false);
  assert.match(manifest.capabilities.refresh_policy.rationale, /version compatibility.*unproven/i);
});
