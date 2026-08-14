// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consent + owner-device-auth conformance — production-store-backed driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/consent-device-auth-conformance.js` against the *production*
 * `ConsentStore` and `OwnerDeviceAuthStore` interfaces in
 * `server/stores/`. The harness running green here is the gate that says
 * the production store seams — which now back the route handlers in
 * `server/index.js` — preserve every lifecycle invariant the harness
 * pins.
 *
 * The companion `consent-device-auth-conformance.test.js` keeps the
 * direct-helpers driver pinned as the original baseline; both must
 * stay green.
 *
 * Spec: openspec/changes/extract-low-risk-reference-stores/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from "node:test";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { runConsentDeviceAuthConformance } from "./helpers/consent-device-auth-conformance.ts";
import { createProductionConsentDeviceAuthDriver } from "./helpers/production-consent-device-auth-driver.ts";

runConsentDeviceAuthConformance({
  label: "production-store",
  makeDriver: () => {
    const driver = createProductionConsentDeviceAuthDriver();
    return {
      ...driver,
      async setup() {
        await driver.setup();
        const connectorId = driver.getRegisteredConnectorId();
        const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
        const now = new Date().toISOString();
        await createSqliteConnectorInstanceStore().upsert({
          connectorId: canonicalId,
          connectorInstanceId: "cin_conformance_spotify",
          createdAt: now,
          displayName: "Spotify",
          ownerSubjectId: "owner_local",
          sourceBinding: { kind: "test_account", label: "consent-conformance-spotify" },
          sourceBindingKey: "consent-conformance-spotify",
          sourceKind: "account",
          status: "active",
          updatedAt: now,
        });
      },
    };
  },
  test,
});
