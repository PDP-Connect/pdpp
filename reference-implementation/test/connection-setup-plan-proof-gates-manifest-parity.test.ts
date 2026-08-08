// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the two highest-risk proof gates in connection-setup-plan.ts —
 * PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS and
 * STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS — against the real shipped
 * manifests' `capabilities.proven.provider_auth_lifecycle` and
 * `capabilities.proven.static_secret_live.proven` declarations.
 *
 * These are PROOF GATES, not classifications: they gate whether a connector
 * may advertise `open_provider_auth` / present as `static_secret_connect`
 * (vs. `experimental`) to the owner. A wrong answer here lets an unproven
 * connector advertise a setup path it cannot honor — a security-relevant
 * regression, not just a UX one. Per the task that added this test,
 * "erring toward keeping the guard is correct" — this test only ever
 * widens/narrows the constant to match an explicit manifest declaration a
 * human wrote, never derives it from an unrelated existing field. It does
 * NOT reuse `capabilities.public_listing.status` as a proxy: that field
 * legitimately disagrees with these proof gates today (e.g. notion/oura are
 * `public_listing.status: "proven"` but have never had a live static-secret
 * env-free run; google-maps-data-portability has a proven auth *lifecycle*
 * while its `public_listing.status` stays "unproven" because archive/resource
 * parsing is separately unproven) — see
 * docs/inbox/report-clusters-bc-completion.md.
 *
 * `test_provider` is a synthetic, non-shipped connector constructed only in
 * test/provider-auth-lifecycle.test.ts fixtures; it has no manifest file and
 * is deliberately excluded from manifest-derivation, matching the code
 * comment on PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS.
 *
 * connection-setup-plan.ts is imported by apps/console and stays free of
 * node:fs, so it cannot itself scan the manifests directory at load time.
 * This test is the substitute — same shape as
 * connection-setup-plan-browser-bound-manifest-parity.test.ts and
 * connection-setup-plan-local-collector-proven-manifest-parity.test.ts.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS,
  STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS,
} from "../server/connection-setup-plan.ts";

const MANIFESTS_DIR = new URL("../../packages/polyfill-connectors/manifests/", import.meta.url);
const SYNTHETIC_TEST_ONLY_KEYS = new Set(["test_provider"]);

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

function readManifests(): ManifestProvenCapabilities[] {
  const manifests: ManifestProvenCapabilities[] = [];
  for (const entry of readdirSync(MANIFESTS_DIR)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    manifests.push(JSON.parse(readFileSync(new URL(entry, MANIFESTS_DIR), "utf8")) as ManifestProvenCapabilities);
  }
  return manifests;
}

// biome-ignore-start lint/suspicious/useArraySortCompare: these helpers rely on the platform default lexical sort behavior.
function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}
// biome-ignore-end lint/suspicious/useArraySortCompare: these helpers rely on the platform default lexical sort behavior.

test("PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS matches exactly (manifest-declared keys + the synthetic test-only key)", () => {
  const manifests = readManifests();
  const manifestDerived = manifests
    .filter((m) => m.capabilities?.proven?.provider_auth_lifecycle === true)
    .map((m) => m.connector_key ?? m.connector_id)
    .filter((key): key is string => typeof key === "string");

  const hardcoded = [...PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS];
  const hardcodedSynthetic = hardcoded.filter((key) => SYNTHETIC_TEST_ONLY_KEYS.has(key));
  const hardcodedManifestBacked = sortedStrings(hardcoded.filter((key) => !SYNTHETIC_TEST_ONLY_KEYS.has(key)));

  assert.deepEqual(
    hardcodedManifestBacked,
    sortedStrings(manifestDerived),
    "PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS (manifest-backed entries) has drifted from the manifests' capabilities.proven.provider_auth_lifecycle declarations"
  );
  assert.deepEqual(
    hardcodedSynthetic,
    ["test_provider"],
    "the only non-manifest-backed entry in PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS must be the synthetic test_provider connector"
  );
});

test("STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS matches exactly the manifests declaring capabilities.proven.static_secret_live.proven", () => {
  const manifests = readManifests();
  const manifestDerived = manifests
    .filter((m) => m.capabilities?.proven?.static_secret_live?.proven === true)
    .map((m) => m.connector_key ?? m.connector_id)
    .filter((key): key is string => typeof key === "string");

  assert.deepEqual(
    sortedStrings(STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS),
    sortedStrings(manifestDerived),
    "STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS has drifted from the manifests' capabilities.proven.static_secret_live.proven declarations — update the constant (or the manifest) so they agree. This is a proof gate: never widen it without a real dated live env-free run."
  );
});

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
