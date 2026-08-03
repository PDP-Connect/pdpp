// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bundle-local mirror of the connector-output protocol's
// `SKIP_RESULT.recovery_hint.action` vocabulary.
//
// The single source of truth is packages/reference-contract/src/common/recovery-actions.ts.
// This file exists only because @pdpp/polyfill-connectors' safe-diagnostics.ts
// compiles into @pdpp/local-collector's publishable dist, which cannot declare
// a dependency on @pdpp/reference-contract (private, unpublished, and outside
// local-collector's package boundary — see local-collector/scripts/validate-package.ts).
// A relative import keeps this module self-contained inside that boundary.
//
// Do not hand-edit the value set here. `recovery-actions-parity.test.ts`
// asserts this Set is identical to the canonical one on every test run, so
// growing the shared vocabulary requires updating both files or the test
// fails loudly instead of silently drifting.
export const RECOVERY_ACTIONS = new Set([
  "retry_by_runtime",
  "retry_on_connector_upgrade",
  "refresh_credentials",
  "manual_action_required",
  "update_selector",
  "capture_live_surface",
  "requires_browser_runtime",
  "upstream_unblock",
  "not_retriable",
  "unknown",
]);
