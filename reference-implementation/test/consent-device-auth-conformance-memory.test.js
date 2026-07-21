/**
 * Consent + owner-device-auth conformance — conforming in-memory adapter.
 *
 * Runs the same reusable conformance scenarios from
 * `helpers/consent-device-auth-conformance.js` against a *conforming* second
 * adapter implemented entirely in-memory in
 * `helpers/memory-consent-device-auth-driver.js`.
 *
 * Together with `consent-device-auth-conformance.test.js` (SQLite reference)
 * and `consent-device-auth-conformance-falsifiability.test.js` (deliberately
 * broken driver), this completes the storage-only security proof for
 * `define-reference-operation-environments` task 3.1: the harness must run
 * green against SQLite and a second conforming adapter, and must fail loudly
 * against a broken adapter. If only SQLite were tested, the harness would
 * be indistinguishable from a SQLite regression suite; if only the broken
 * driver were tested, the harness would only prove falsifiability, not
 * adapter swap.
 *
 * The memory driver is test-only and SHALL NOT be promoted to a production
 * `ConsentStore` / `OwnerDeviceAuthStore` adapter. See driver header for
 * honesty boundaries.
 *
 * Spec: openspec/changes/define-reference-operation-environments/tasks.md §3.1.
 */

import test from 'node:test';

import { runConsentDeviceAuthConformance } from './helpers/consent-device-auth-conformance.js';
import { createMemoryConsentDeviceAuthDriver } from './helpers/memory-consent-device-auth-driver.js';

runConsentDeviceAuthConformance({
  label: 'memory-second-adapter',
  test,
  makeDriver: () => createMemoryConsentDeviceAuthDriver(),
});
