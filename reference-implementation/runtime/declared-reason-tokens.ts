// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-connector declared-reason-token registry, keyed by canonical connector
 * id — the ONE place the RS-side runtime (`connector-gap-bounding.ts`'s
 * `boundConnectorErrorMessage`) looks up which >=24-char snake_case tokens a
 * connector's own thrown-error vocabulary is allowed to keep verbatim
 * through `stderr-redact.ts`'s `LONG_OPAQUE_RE` entropy heuristic.
 *
 * Why this exists: `runtime/stderr-redact.ts`'s `declaredReasonTokens`
 * mechanism (added for a 2026-08-18 HEB incident —
 * `heb_session_failed: [REDACTED]`) was wired into `run-logger.ts` (internal
 * scheduler/executor logging) but never into `boundConnectorErrorMessage`,
 * the function that actually redacts `connector_error_json.message` before
 * it reaches a durable spine event and the owner's UI. That gap is why
 * Venmo's first live run (`run_1787101857760`, 2026-08-18) hit the SAME
 * defect the mechanism was built to fix: `venmo_session_failed: [REDACTED]:
 * Failed to fetch`, the eaten token being `venmo_probe_transport_error` (27
 * chars) — a categorical, PII-free fault-class name, not a secret.
 *
 * Each entry imports its token set from the connector's OWN module (e.g.
 * `VENMO_DECLARED_REASON_TOKENS` from `src/auto-login/venmo.ts`, the module
 * that actually throws these) rather than re-typing the strings here — a
 * hand-copied list would silently drift from the connector's real thrown
 * vocabulary the first time a throw site changed. Only connectors that
 * actually need it are registered; every connector NOT listed here gets
 * exactly today's `boundConnectorErrorMessage` behavior (byte-identical — an
 * absent entry is treated as an empty set).
 *
 * Imports from `src/auto-login/venmo.ts` directly rather than
 * `connectors/venmo/index.ts` (the connector's CLI entry point) — the latter
 * is a heavier module graph (browser-runtime wiring, `runConnector`
 * bootstrap) this RS-side server has no reason to pull in, and re-exporting
 * a value through it would be a barrel-file re-export this repo's Biome
 * config (`noBarrelFile`) already rejects.
 *
 * Scope: this registry currently covers only Venmo, the connector this fix
 * was written for. HEB has the same defect class (its own
 * `heb_verification_code_not_provided`/etc. tokens are also >=24 chars) but
 * is not yet registered — a follow-up, not silently included here.
 */

import { VENMO_DECLARED_REASON_TOKENS } from "../../packages/polyfill-connectors/src/auto-login/venmo.ts";

const DECLARED_REASON_TOKENS_BY_CONNECTOR_ID: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["venmo", VENMO_DECLARED_REASON_TOKENS],
]);

/**
 * Look up the declared reason tokens for a canonical connector id. Returns
 * `undefined` (not an empty Set) for an unregistered connector, matching
 * `StderrRedactionOptions.declaredReasonTokens`'s own optional shape so a
 * caller can spread this straight into `redactStderrTail`'s options without
 * an extra "is this empty" branch.
 */
export function declaredReasonTokensFor(connectorId: string): ReadonlySet<string> | undefined {
  return DECLARED_REASON_TOKENS_BY_CONNECTOR_ID.get(connectorId);
}
