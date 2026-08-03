// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for the connector-output protocol's
// `SKIP_RESULT.recovery_hint.action` vocabulary.
//
// Every connector (Slack, USAA, Chase, Gmail, ...) and every consumer that
// re-validates or re-sanitizes a `recovery_hint` (runtime protocol
// validation, polyfill-connectors' safe-diagnostics projection, any future
// consumer) MUST import `RECOVERY_ACTIONS` from here rather than maintain
// its own copy. A second, independently-maintained allowlist is exactly
// how `requires_browser_runtime` shipped in the Slack connector on one side
// of the contract without being registered on the other — see the
// `attention-slack-protocol-0803` incident. Add new action values here
// ONLY; never introduce a second Set anywhere in the monorepo.
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
