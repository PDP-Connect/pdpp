// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RI-owned generic recovery reason vocabulary: the finite set of connector-neutral
 * codes that recovery-decision.ts classifies as normalized recovery classes.
 * This module has no external dependencies, allowing test packages to import
 * the authoritative reason set without pulling in server-side modules (auth, CIMD, etc.)
 * that have incompatible lib typings.
 *
 * This is the single source of truth for generic recovery codes.
 * display-messages.ts checks that all codes here have vetted copy.
 * recovery-decision.ts imports from here to classify reasons.
 * The connector test imports from here to check connector-emitted codes.
 */

/** Codes indicating source pressure rather than a connector defect. */
export const PROVIDER_PRESSURE_REASONS: ReadonlySet<string> = new Set(["rate_limited", "upstream_pressure"]);

/**
 * Codes requiring owner re-authentication (auth failure, credential expiry).
 */
export const OWNER_REQUIRED_REASONS: ReadonlySet<string> = new Set(["auth_failure"]);

/**
 * Codes indicating connector/system defects or permanent unavailability.
 */
export const CONNECTOR_DEFECT_REASONS: ReadonlySet<string> = new Set([
  "gone",
  "not_found",
  "permanent_forbidden",
  "quarantined",
]);

/**
 * Informational, non-recoverable reason codes (user disabled, out of scope).
 */
export const INFORMATIONAL_RECOVERY_REASONS: ReadonlySet<string> = new Set([
  "not_available_in_mode",
  "out_of_scope",
  "user_disabled",
]);

/**
 * Complete set of RI-owned generic reason codes.
 * Test code (`reason-display-messages.test.ts`) imports this to verify all
 * connector-emitted reasons have display copy. display-messages.ts uses this
 * to verify all codes have corresponding vetted copy.
 */
export const RUNTIME_GENERIC_REASON_CODES: ReadonlySet<string> = new Set([
  ...PROVIDER_PRESSURE_REASONS,
  ...OWNER_REQUIRED_REASONS,
  ...CONNECTOR_DEFECT_REASONS,
  ...INFORMATIONAL_RECOVERY_REASONS,
  "retry_exhausted",
  "run_cap_deferred",
  "temporary_unavailable",
]);
