// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reason-code → end-user display-message contract for RI's OWN generic
 * recovery vocabulary. No production code calls `displayMessageFor` today
 * (verified: `rg` finds no call site outside this file and its test) — this
 * module is a contract/test-utility pinning what RI is allowed to claim
 * generic copy for, available for a future consumer to wire up, not an
 * active UI dependency. Don't infer otherwise from its name.
 *
 * This file carries ZERO connector/provider-specific knowledge (the
 * zero-connector-knowledge conformance guard,
 * `test/ri-zero-connector-knowledge-conformance.test.ts`, enforces this for
 * all of `reference-implementation`'s production code). Connector-emitted
 * reason codes and their vetted end-user copy are NOT this file's concern at
 * all, in either direction — RI production code must not import
 * `@pdpp/polyfill-connectors` (the dependency direction runs the other way;
 * see `runtime/scheduler-readiness.ts`'s note on the same boundary), and
 * this file makes no claim to cover connector codes, merge with them, or be
 * composed with them by some other caller.
 *
 * Reason-code display-copy completeness ("every connector-emitted reason
 * code has vetted end-user copy") is authority the CONNECTOR PACKAGE owns
 * and tests against itself:
 *   - a connector declares its own copy in its own manifest
 *     (`reason_display_messages`, an optional
 *     `Record<reason_code, display_message>` field);
 *   - `packages/polyfill-connectors/src/reason-display-messages.ts` merges
 *     every manifest's declarations
 *     (`connectorReasonDisplayMessage`/`connectorReasonDisplayMessages`);
 *   - `packages/polyfill-connectors/src/reason-display-messages.test.ts`
 *     AST-scans every connector's OWN PRODUCTION DIRECTORY (not just
 *     `index.ts` — see `reason-emission-scan.ts`'s doc comment for the
 *     file-scope and one-hop-resolution rules) for reason codes actually
 *     reaching a `SKIP_RESULT`/`connector_error`/`DETAIL_GAP` emission, and
 *     asserts each one is covered by EITHER that connector's own manifest
 *     declaration OR this file's `RUNTIME_GENERIC_REASON_CODES` (imported
 *     there by relative path, the same cross-package pattern several
 *     existing RI tests already use — test code is exempt from the RI-side
 *     zero-connector-knowledge import restriction, but the completeness
 *     test itself lives in, and is owned by, the connector package, not RI).
 *
 * A small, closed set of reason codes are RI's OWN normalized
 * recovery-classification vocabulary — `runtime/recovery-decision.ts`
 * already gives these codes protocol-level meaning independent of any
 * connector (`classifyRecoveryReason`, `PROVIDER_PRESSURE_REASONS`,
 * `OWNER_REQUIRED_REASONS`, `CONNECTOR_DEFECT_REASONS`,
 * `INFORMATIONAL_RECOVERY_REASONS`, plus the three literal `RecoveryClass`
 * members not covered by those sets). Those, and only those, get
 * RI-authored copy in `RUNTIME_GENERIC_DISPLAY_MESSAGES` below — imported
 * directly from the sets that define them, so this file cannot silently
 * drift from what the runtime actually treats as generic. This is not a
 * judgment call re-made here each time a new connector reason happens to
 * look reusable; it is exactly, and only, the vocabulary another RI module
 * already owns. `reason-display-messages.test.ts` (in the connector
 * package) also asserts no connector manifest declares one of these
 * RI-reserved codes in its own `reason_display_messages`.
 *
 * Copy guidelines (borrowed from Plaid / Linear naming insight):
 *   - End-user language, never protocol jargon.
 *   - Present tense, action-oriented where possible.
 *   - Never expose the raw code as the value (registry values must not
 *     equal their keys — that just relocates the confusion).
 *   - Empty strings are forbidden.
 */

import { RUNTIME_GENERIC_REASON_CODES } from "./recovery-reason-codes.ts";

/** Vetted end-user copy for the RI-owned generic recovery vocabulary. */
const RUNTIME_GENERIC_DISPLAY_MESSAGES: Record<string, string> = {
  auth_failure: "Your sign-in expired and needs to be renewed before we can continue",
  gone: "That item is no longer available at the source",
  not_available_in_mode: "This data isn't available through the current connection",
  not_found: "We couldn't find that item at the source",
  out_of_scope: "This item is outside what you've chosen to collect",
  permanent_forbidden: "The source won't let us access that item",
  quarantined: "We paused retrying this item after repeated failures — it needs a look",
  rate_limited: "The service is limiting how fast we can read from it right now — we'll back off and try later",
  retry_exhausted: "We used up this run's retries here, so we'll pick the rest up on the next run",
  run_cap_deferred:
    "We collected a batch within this run's budget and saved it; the rest will be collected on the next run",
  temporary_unavailable: "We couldn't finish this item yet, so we'll try it again on the next run",
  upstream_pressure: "The service is busy right now — we'll back off and try later",
  user_disabled: "This was turned off in your collection settings",
};

const missingCopy = [...RUNTIME_GENERIC_REASON_CODES].filter((code) => !(code in RUNTIME_GENERIC_DISPLAY_MESSAGES));
if (missingCopy.length > 0) {
  throw new Error(
    `RUNTIME_GENERIC_DISPLAY_MESSAGES is missing vetted copy for: ${missingCopy.join(", ")} — ` +
      "every code in recovery-reason-codes.ts's RUNTIME_GENERIC_REASON_CODES must have an entry."
  );
}

/**
 * RI's generic-only registry. Does NOT include connector-specific copy —
 * see this file's top-of-file doc comment for where that lives. Exposed for
 * tests/introspection; prefer `displayMessageFor` for lookups.
 */
export const DISPLAY_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...RUNTIME_GENERIC_DISPLAY_MESSAGES,
});

/**
 * Look up RI's own generic vetted end-user copy for a reason code. Returns
 * `null` for a connector-specific code (see
 * `@pdpp/polyfill-connectors/src/reason-display-messages.ts` for those) or
 * any unregistered code — the caller is responsible for whatever
 * loud-and-honest fallback copy it wants to show.
 */
export function displayMessageFor(reasonCode: string | null): string | null {
  if (!reasonCode) {
    return null;
  }
  return DISPLAY_MESSAGES[reasonCode] ?? null;
}
