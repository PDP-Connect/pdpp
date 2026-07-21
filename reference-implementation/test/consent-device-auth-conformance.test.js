/**
 * Consent + owner-device-auth conformance — SQLite reference driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/consent-device-auth-conformance.js` against the current
 * SQLite-backed reference auth helpers (`initiateGrant`, `approveGrant`,
 * `denyGrant`, `getPendingConsent`, `getPendingConsentRowByApprovalId`,
 * `initiateOwnerDeviceAuthorization`, `approveOwnerDeviceAuthorization`,
 * `denyOwnerDeviceAuthorization`, `exchangeOwnerDeviceCode`,
 * `getOwnerDeviceAuthorizationByUserCode`, `getOwnerDeviceAuthRowByApprovalId`).
 *
 * Replaces nothing on its own; the focused route-level auth/security suites
 * (`owner-auth.test.js`, `owner-csrf.test.js`,
 * `security-device-code-exposure.test.js`,
 * `security-consent-token-handoff.test.js`) remain as direct evidence
 * alongside this conformance run. See worker report for rationale.
 *
 * Spec: openspec/changes/add-consent-device-auth-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { runConsentDeviceAuthConformance } from './helpers/consent-device-auth-conformance.js';
import { createSqliteConsentDeviceAuthDriver } from './helpers/sqlite-consent-device-auth-driver.js';

runConsentDeviceAuthConformance({
  label: 'sqlite-reference',
  test,
  makeDriver: () => createSqliteConsentDeviceAuthDriver(),
});
