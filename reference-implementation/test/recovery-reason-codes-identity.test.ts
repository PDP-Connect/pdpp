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
import {
  CONNECTOR_DEFECT_REASONS as RECOVERY_DECISION_CONNECTOR_DEFECT,
  INFORMATIONAL_RECOVERY_REASONS as RECOVERY_DECISION_INFORMATIONAL,
  OWNER_REQUIRED_REASONS as RECOVERY_DECISION_OWNER_REQUIRED,
  PROVIDER_PRESSURE_REASONS as RECOVERY_DECISION_PROVIDER_PRESSURE,
} from "../runtime/recovery-decision.ts";
import { SOURCE_PRESSURE_GAP_REASONS } from "../runtime/scheduler-source-pressure-cooldown.ts";

test("recovery-reason-codes: all imports reference same Set instances (no duplication)", () => {
  // Recovery-decision.ts re-exports from recovery-reason-codes.ts; verify referential equality.
  assert.strictEqual(
    PROVIDER_PRESSURE_REASONS,
    RECOVERY_DECISION_PROVIDER_PRESSURE,
    "PROVIDER_PRESSURE_REASONS must be identical object"
  );
  assert.strictEqual(
    OWNER_REQUIRED_REASONS,
    RECOVERY_DECISION_OWNER_REQUIRED,
    "OWNER_REQUIRED_REASONS must be identical object"
  );
  assert.strictEqual(
    CONNECTOR_DEFECT_REASONS,
    RECOVERY_DECISION_CONNECTOR_DEFECT,
    "CONNECTOR_DEFECT_REASONS must be identical object"
  );
  assert.strictEqual(
    INFORMATIONAL_RECOVERY_REASONS,
    RECOVERY_DECISION_INFORMATIONAL,
    "INFORMATIONAL_RECOVERY_REASONS must be identical object"
  );

  // SOURCE_PRESSURE_GAP_REASONS is an alias for PROVIDER_PRESSURE_REASONS.
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
