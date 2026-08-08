// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins SUPPORTED_LOCAL_COLLECTOR_CONNECTORS (connection-setup-plan.ts)
 * against the real shipped manifests' `capabilities.proven.local_collector`
 * declaration.
 *
 * This is a PROOF GATE, not a classification: `runtime_requirements.
 * bindings.filesystem` alone tells you a connector is filesystem-backed
 * (13 shipped manifests), but only a subset has a proven, connector-specific
 * local-collector enrollment path (6 today). Deriving the gate from the
 * binding alone would silently promote unproven connectors (apple-health,
 * google-maps, ical, netflix-export, slack, twitter-archive, whatsapp) to
 * "supported" — a real security/UX regression the task that added this test
 * was explicitly warned against. `capabilities.proven.local_collector` is a
 * separate, narrower manifest fact than `capabilities.public_listing`
 * (dashboard-catalog visibility) — they legitimately disagree: e.g.
 * google_takeout is proven for local-collector setup but still
 * `public_listing.status: "unproven"` for dashboard-listing purposes.
 *
 * connection-setup-plan.ts is imported by apps/console and stays free of
 * node:fs, so it cannot itself scan the manifests directory at load time.
 * This test is the substitute: it proves the hand-maintained allowlist is
 * exactly the set of manifests declaring the proof, so a future manifest
 * gaining/losing `capabilities.proven.local_collector` without updating
 * SUPPORTED_LOCAL_COLLECTOR_CONNECTORS fails CI instead of silently
 * drifting — same shape as
 * connection-setup-plan-browser-bound-manifest-parity.test.ts. See
 * docs/inbox/report-clusters-bc-completion.md.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { enrollmentKeyForCanonicalKey, SUPPORTED_LOCAL_COLLECTOR_CONNECTORS } from "../server/connection-setup-plan.ts";

const MANIFESTS_DIR = new URL("../../packages/polyfill-connectors/manifests/", import.meta.url);
const JSON_EXTENSION_RE = /\.json$/;

function manifestDeclaredProvenLocalCollectorEnrollmentKeys(): string[] {
  const keys: string[] = [];
  for (const entry of readdirSync(MANIFESTS_DIR)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const raw = JSON.parse(readFileSync(new URL(entry, MANIFESTS_DIR), "utf8")) as {
      connector_key?: string;
      connector_id?: string;
      capabilities?: { proven?: { local_collector?: unknown } };
    };
    if (raw.capabilities?.proven?.local_collector === true) {
      const key = raw.connector_key ?? raw.connector_id ?? entry.replace(JSON_EXTENSION_RE, "");
      keys.push(enrollmentKeyForCanonicalKey(key));
    }
  }
  // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
  return keys.sort();
}

test("SUPPORTED_LOCAL_COLLECTOR_CONNECTORS matches exactly the manifests declaring capabilities.proven.local_collector", () => {
  const derived = manifestDeclaredProvenLocalCollectorEnrollmentKeys();
  const hardcoded = [...SUPPORTED_LOCAL_COLLECTOR_CONNECTORS].sort();
  assert.deepEqual(
    hardcoded,
    derived,
    "SUPPORTED_LOCAL_COLLECTOR_CONNECTORS has drifted from the manifests' capabilities.proven.local_collector declarations — update the constant (or the manifest) so they agree. This is a proof gate: never widen it to match a manifest change without confirming the connector's local-collector path is actually proven."
  );
});

test("no manifest with a filesystem binding advertises capabilities.proven.local_collector unless it also has runtime_requirements.bindings.filesystem", () => {
  // Guards the inverse direction: a manifest cannot claim the local-collector
  // proof without also declaring the binding that makes the capability
  // meaningful. This is the regression the task's method explicitly calls
  // out: "a malformed manifest ever claims a capability its declared setup
  // modality cannot support."
  for (const entry of readdirSync(MANIFESTS_DIR)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const raw = JSON.parse(readFileSync(new URL(entry, MANIFESTS_DIR), "utf8")) as {
      connector_key?: string;
      runtime_requirements?: { bindings?: Record<string, unknown> };
      capabilities?: { proven?: { local_collector?: unknown } };
    };
    if (raw.capabilities?.proven?.local_collector === true) {
      const bindings = raw.runtime_requirements?.bindings;
      const hasFilesystemBinding = Boolean(
        bindings && typeof bindings === "object" && Object.hasOwn(bindings, "filesystem")
      );
      assert.ok(
        hasFilesystemBinding,
        `${entry} declares capabilities.proven.local_collector=true but has no runtime_requirements.bindings.filesystem — a proven local-collector connector must be filesystem-bound`
      );
    }
  }
});
