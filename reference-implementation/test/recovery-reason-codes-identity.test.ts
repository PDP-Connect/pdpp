// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_DEFECT_REASONS,
  INFORMATIONAL_RECOVERY_REASONS,
  OWNER_REQUIRED_REASONS,
  PROVIDER_PRESSURE_REASONS,
  RUNTIME_GENERIC_REASON_CODES,
} from "../runtime/recovery-reason-codes.ts";
import { SOURCE_PRESSURE_GAP_REASONS } from "../runtime/scheduler-source-pressure-cooldown.ts";

test("recovery reason consumers share the authoritative pressure set", () => {
  assert.strictEqual(
    PROVIDER_PRESSURE_REASONS,
    SOURCE_PRESSURE_GAP_REASONS,
    "SOURCE_PRESSURE_GAP_REASONS must be identical to PROVIDER_PRESSURE_REASONS"
  );

  // RUNTIME_GENERIC_REASON_CODES must contain all four reason sets.
  const expectedCodes = new Set([
    ...PROVIDER_PRESSURE_REASONS,
    ...OWNER_REQUIRED_REASONS,
    ...CONNECTOR_DEFECT_REASONS,
    ...INFORMATIONAL_RECOVERY_REASONS,
    "retry_exhausted",
    "run_cap_deferred",
    "temporary_unavailable",
  ]);
  assert.deepStrictEqual(
    RUNTIME_GENERIC_REASON_CODES,
    expectedCodes,
    "RUNTIME_GENERIC_REASON_CODES must contain all reason codes"
  );
});
