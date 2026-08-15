// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS and
 * STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS (connection-setup-plan.ts) are now
 * generated from the shipped manifests' `capabilities.proven.
 * provider_auth_lifecycle` / `capabilities.proven.static_secret_live.proven`
 * declarations (server/generated/connector-registry.generated.ts, produced by
 * scripts/generate-connector-registry.ts). The two parity tests this file
 * used to run — re-scanning the manifests here and diffing against those
 * constants — compared two manifest-derived readings against each other, a
 * near-tautology now that test/connector-registry-manifest-derivation.test.ts's
 * drift oracle already byte-compares the tracked generated file against a
 * live run of the real generator (a strictly stronger check: it exercises
 * the actual generator code, not a second hand-written re-derivation).
 * Those two tests were dropped here for that reason; the
 * PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS test's synthetic
 * "test_provider" check moved to
 * test/connector-registry-manifest-derivation.test.ts's own coverage of
 * connection-setup-plan.ts's non-generated literal addition.
 *
 * This file keeps the check that is NOT redundant with the drift oracle: a
 * live, independent proof — against every manifest actually shipped today,
 * not synthetic fixtures — that a manifest can never claim
 * `capabilities.proven.static_secret_live.proven` or
 * `capabilities.proven.provider_auth_lifecycle` without also declaring the
 * `setup.modality` that proof requires. These are PROOF GATES, not
 * classifications: they gate whether a connector may advertise
 * `open_provider_auth` / present as `static_secret_connect` (vs.
 * `experimental`) to the owner, so a wrong answer here is a
 * security-relevant regression, not just a UX one.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const MANIFESTS_DIR = new URL("../../packages/polyfill-connectors/manifests/", import.meta.url);

interface ManifestProvenCapabilities {
  capabilities?: {
    proven?: {
      provider_auth_lifecycle?: unknown;
      static_secret_live?: { proven?: unknown };
    };
  };
  connector_id?: string;
  connector_key?: string;
}

test("no manifest claims a proven capability its declared setup modality cannot support", () => {
  // Regression guard demanded by the task: a malformed manifest must not be
  // able to claim static_secret_live proof without declaring the
  // static_secret setup modality, or provider_auth_lifecycle proof without
  // declaring the provider_authorization setup modality.
  for (const entry of readdirSync(MANIFESTS_DIR)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const raw = JSON.parse(readFileSync(new URL(entry, MANIFESTS_DIR), "utf8")) as ManifestProvenCapabilities & {
      setup?: { modality?: unknown };
    };
    const proven = raw.capabilities?.proven;
    if (proven?.static_secret_live?.proven === true) {
      assert.equal(
        raw.setup?.modality,
        "static_secret",
        `${entry} declares capabilities.proven.static_secret_live.proven=true but setup.modality is not "static_secret"`
      );
    }
    if (proven?.provider_auth_lifecycle === true) {
      assert.equal(
        raw.setup?.modality,
        "provider_authorization",
        `${entry} declares capabilities.proven.provider_auth_lifecycle=true but setup.modality is not "provider_authorization"`
      );
    }
  }
});
