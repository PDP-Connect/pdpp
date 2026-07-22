// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consent + owner-device-auth conformance -- Postgres proof adapter.
 *
 * Runs the reusable consent/device-auth lifecycle scenarios against a
 * Postgres-backed proof driver when `PDPP_TEST_POSTGRES_URL` is set. When the
 * env var is unset, registers a skipped test so default development and CI do
 * not require a Postgres service.
 */

import test from 'node:test';

import { runConsentDeviceAuthConformance } from './helpers/consent-device-auth-conformance.js';
import { createPostgresConsentDeviceAuthDriver } from './helpers/postgres-consent-device-auth-driver.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres consent/device-auth conformance (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  runConsentDeviceAuthConformance({
    label: 'postgres-consent-device-auth',
    test,
    makeDriver: () => createPostgresConsentDeviceAuthDriver({ connectionString: POSTGRES_URL }),
  });
}
