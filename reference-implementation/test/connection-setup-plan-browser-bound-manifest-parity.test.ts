// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins BROWSER_BOUND_CONNECTORS (connection-setup-plan.ts) against the real
 * shipped manifests' `runtime_requirements.bindings.browser` declaration.
 *
 * connection-setup-plan.ts is imported by apps/console and stays free of
 * node:fs so it is safe in any bundling context; that means it cannot itself
 * scan the manifests directory to derive this set at load time. This test is
 * the substitute: it proves the hand-maintained allowlist is exactly the set
 * a manifest scan would produce, so a future manifest gaining/losing a
 * `browser` binding without updating BROWSER_BOUND_CONNECTORS fails CI
 * instead of silently drifting — see
 * docs/inbox/report-connector-knowledge-clusters-bc.md (Cluster B).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { BROWSER_BOUND_CONNECTORS } from "../server/connection-setup-plan.ts";

const MANIFESTS_DIR = new URL("../../packages/polyfill-connectors/manifests/", import.meta.url);

function manifestDeclaredBrowserBoundKeys(): string[] {
  const keys: string[] = [];
  for (const entry of readdirSync(MANIFESTS_DIR)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const raw = JSON.parse(readFileSync(new URL(entry, MANIFESTS_DIR), "utf8")) as {
      connector_key?: string;
      connector_id?: string;
      runtime_requirements?: { bindings?: Record<string, unknown> };
    };
    const bindings = raw.runtime_requirements?.bindings;
    if (bindings && typeof bindings === "object" && Object.hasOwn(bindings, "browser")) {
      const key = raw.connector_key ?? raw.connector_id ?? entry.replace(/\.json$/, "");
      keys.push(key);
    }
  }
  return keys.sort();
}

test("BROWSER_BOUND_CONNECTORS matches exactly the manifests declaring a browser runtime binding", () => {
  const derived = manifestDeclaredBrowserBoundKeys();
  const hardcoded = [...BROWSER_BOUND_CONNECTORS].sort();
  assert.deepEqual(
    hardcoded,
    derived,
    "BROWSER_BOUND_CONNECTORS has drifted from the manifests' runtime_requirements.bindings.browser declarations — update the constant (or the manifest) so they agree"
  );
});
