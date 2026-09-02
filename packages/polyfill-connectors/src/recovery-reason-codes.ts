// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vendored copy of the reference implementation's generic recovery reason
 * vocabulary: the finite set of connector-neutral codes that its own
 * `recovery-decision.ts` classifies as normalized recovery classes.
 *
 * The canonical source lived at
 * `reference-implementation/runtime/recovery-reason-codes.ts` until that
 * directory moved to PDP-Connect/data-connect (Move B). Its own doc comment
 * described it as having "no external dependencies, allowing test packages
 * to import the authoritative reason set without pulling in server-side
 * modules" — this file is that same standalone, dependency-free module,
 * copied here because `reason-display-messages.test.ts` (this package's own
 * test that every connector-emitted reason code has vetted display copy)
 * needs it and can no longer reach across the repo boundary to the original.
 *
 * If the canonical set in data-connect changes, this copy will drift
 * silently — there is no cross-repo drift check wired up for this specific
 * file (unlike `packages/reference-contract`, which has one via
 * `.github/workflows/consumer-drift-signal.yml`). Keep this in sync by hand
 * if data-connect's `recovery-decision.ts` ever adds or removes a generic
 * reason code.
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
 * Complete set of generic reason codes the reference implementation owns.
 * `reason-display-messages.test.ts` imports this to verify all
 * connector-emitted reasons have display copy.
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
