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

import test from 'node:test';

import { runConsentDeviceAuthConformance } from './helpers/consent-device-auth-conformance.js';
import { createProductionConsentDeviceAuthDriver } from './helpers/production-consent-device-auth-driver.js';

runConsentDeviceAuthConformance({
  label: 'production-store',
  test,
  makeDriver: () => createProductionConsentDeviceAuthDriver(),
});
