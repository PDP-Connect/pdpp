// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SUPPORTED_LOCAL_COLLECTOR_CONNECTORS (connection-setup-plan.ts) is now
 * generated from the shipped manifests' `capabilities.proven.local_collector`
 * declaration (server/generated/connector-registry.generated.ts, produced by
 * scripts/generate-connector-registry.ts). A parity test comparing that
 * generated value against a second manifest scan written in this file would
 * be comparing two manifest-derived readings against each other — a
 * near-tautology now that
 * test/connector-registry-manifest-derivation.test.ts's drift oracle already
 * byte-compares the tracked generated file against a live run of the real
 * generator (a strictly stronger check: it exercises the actual generator
 * code, not a second hand-written re-derivation). That parity test was
 * dropped here for that reason.
 *
 * This file keeps only the check that is NOT redundant with the drift
 * oracle: a live, independent proof that the invariant the generator and
 * connector-manifest-validation.ts's validateProvenModalityConsistency both
 * assume — a connector cannot claim `capabilities.proven.local_collector`
 * without also declaring `runtime_requirements.bindings.filesystem` — holds
 * for every manifest actually shipped today, not just synthetic fixtures.
 * (`capabilities.proven.local_collector` is a proof gate, not a
 * classification: `runtime_requirements.bindings.filesystem` alone marks 13
 * shipped manifests as filesystem-backed, but only a subset has a proven,
 * connector-specific local-collector enrollment path — 6 today.)
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const MANIFESTS_DIR = new URL("../../packages/polyfill-connectors/manifests/", import.meta.url);

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
